/**
 * Tests — the language of the sign-in and invitation emails
 *
 * This suite pins where each transactional email's language is decided:
 * `generateMagicLink` for the sign-in link and `createInvite` for the
 * two project invitations. The email helpers are mocked, so the
 * assertion is the language each caller hands them, given the
 * recipient's saved `users.locale`, the workspace's
 * `tenants.default_locale` and the language of the triggering request.
 * The order is saved locale, then workspace default, then request
 * language, then Spanish. For the sign-in link the workspace is the
 * one being signed into, which for a federation grant holder is not
 * their home workspace.
 *
 * @version v0.9.0
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import {
  DEFAULT_TEST_TENANT_ID,
  SECOND_TEST_TENANT_ID,
  applyMigrations,
  cleanDatabase,
  seedTenants,
} from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { generateMagicLink } from "../../app/lib/auth.server";
import { createInvite } from "../../app/lib/invites.server";

vi.mock("../../app/lib/email.server", () => ({
  sendMagicLinkEmail: vi.fn().mockResolvedValue(undefined),
  sendNewUserInviteEmail: vi.fn().mockResolvedValue(undefined),
  sendExistingUserInviteEmail: vi.fn().mockResolvedValue(undefined),
}));

import {
  sendMagicLinkEmail,
  sendNewUserInviteEmail,
  sendExistingUserInviteEmail,
} from "../../app/lib/email.server";

const ORIGIN = "http://localhost:5173";

async function setWorkspaceDefault(
  locale: "en" | "es" | null,
  tenantId: string = DEFAULT_TEST_TENANT_ID,
) {
  await drizzle(env.DB)
    .update(schema.tenants)
    .set({ defaultLocale: locale })
    .where(eq(schema.tenants.id, tenantId));
}

async function setUserLocale(userId: string, locale: "en" | "es" | null) {
  await drizzle(env.DB)
    .update(schema.users)
    .set({ locale })
    .where(eq(schema.users.id, userId));
}

/** The language argument of the mock's single call: always the last one. */
function sentLocale(mock: unknown): string {
  const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls;
  expect(calls).toHaveLength(1);
  return calls[0][calls[0].length - 1] as string;
}

describe("email language", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await setWorkspaceDefault(null);
    await setWorkspaceDefault(null, SECOND_TEST_TENANT_ID);
  });

  describe("sign-in link", () => {
    async function send(requestLocale?: string, workspaceId?: string) {
      const db = drizzle(env.DB, { schema });
      const result = await generateMagicLink(
        db,
        "reader@example.com",
        ORIGIN,
        "test-resend-key",
        {},
        requestLocale,
        workspaceId,
      );
      expect(result.success).toBe(true);
      return sentLocale(sendMagicLinkEmail);
    }

    it("uses the saved locale over the workspace default and the request", async () => {
      const user = await createTestUser({ email: "reader@example.com" });
      await setUserLocale(user.id, "en");
      await setWorkspaceDefault("es");
      expect(await send("es")).toBe("en");
    });

    it("uses the workspace default over the request when no locale is saved", async () => {
      await createTestUser({ email: "reader@example.com" });
      await setWorkspaceDefault("en");
      expect(await send("es")).toBe("en");
    });

    it("uses the request language when neither is set", async () => {
      await createTestUser({ email: "reader@example.com" });
      expect(await send("en")).toBe("en");
    });

    it("uses the default of the workspace being signed into, not the home workspace", async () => {
      // A grant holder whose home workspace defaults to English signs
      // into a member workspace that defaults to Spanish.
      await seedTenants();
      await createTestUser({ email: "reader@example.com" });
      await setWorkspaceDefault("en");
      await setWorkspaceDefault("es", SECOND_TEST_TENANT_ID);
      expect(await send("en", SECOND_TEST_TENANT_ID)).toBe("es");
    });

    it("keeps the saved locale ahead of the workspace being signed into", async () => {
      await seedTenants();
      const user = await createTestUser({ email: "reader@example.com" });
      await setUserLocale(user.id, "en");
      await setWorkspaceDefault("es", SECOND_TEST_TENANT_ID);
      expect(await send("es", SECOND_TEST_TENANT_ID)).toBe("en");
    });

    it("falls back to Spanish with no request language", async () => {
      await createTestUser({ email: "reader@example.com" });
      expect(await send()).toBe("es");
    });
  });

  describe("project invitations", () => {
    async function createProject(leadId: string) {
      const db = drizzle(env.DB);
      const now = Date.now();
      const projectId = crypto.randomUUID();
      await db.insert(schema.projects).values({
        id: projectId,
        tenantId: DEFAULT_TEST_TENANT_ID,
        name: "Test Project",
        createdBy: leadId,
        createdAt: now,
        updatedAt: now,
      });
      return projectId;
    }

    async function invite(
      lead: { id: string; email: string; name: string | null },
      projectId: string,
      email: string,
      requestLocale?: string,
    ) {
      return createInvite(
        drizzle(env.DB),
        DEFAULT_TEST_TENANT_ID,
        projectId,
        email,
        ["cataloguer"],
        lead,
        ORIGIN,
        "test-resend-key",
        {},
        requestLocale,
      );
    }

    it("writes to an existing user in their saved locale", async () => {
      const lead = await createTestUser({ name: "Lead" });
      const member = await createTestUser({ email: "member@example.com" });
      await setUserLocale(member.id, "en");
      await setWorkspaceDefault("es");
      const projectId = await createProject(lead.id);

      const result = await invite(lead, projectId, "member@example.com", "es");
      expect(result.status).toBe("added");
      expect(sentLocale(sendExistingUserInviteEmail)).toBe("en");
    });

    it("writes to an existing user without a locale in the workspace default", async () => {
      const lead = await createTestUser({ name: "Lead" });
      await createTestUser({ email: "member@example.com" });
      await setWorkspaceDefault("en");
      const projectId = await createProject(lead.id);

      await invite(lead, projectId, "member@example.com", "es");
      expect(sentLocale(sendExistingUserInviteEmail)).toBe("en");
    });

    it("writes to a new user in the workspace default over the request", async () => {
      const lead = await createTestUser({ name: "Lead" });
      await setWorkspaceDefault("en");
      const projectId = await createProject(lead.id);

      const result = await invite(lead, projectId, "new@example.com", "es");
      expect(result.status).toBe("invited");
      expect(sentLocale(sendNewUserInviteEmail)).toBe("en");
    });

    it("writes to a new user in the request language when the workspace sets none", async () => {
      const lead = await createTestUser({ name: "Lead" });
      const projectId = await createProject(lead.id);

      await invite(lead, projectId, "new@example.com", "en");
      expect(sentLocale(sendNewUserInviteEmail)).toBe("en");
    });

    it("writes to a new user in Spanish with no other source", async () => {
      const lead = await createTestUser({ name: "Lead" });
      const projectId = await createProject(lead.id);

      await invite(lead, projectId, "new@example.com");
      expect(sentLocale(sendNewUserInviteEmail)).toBe("es");
    });
  });
});

// @version v0.9.0
