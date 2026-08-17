/**
 * Tests — notification sweep and digest rendering
 *
 * Covers `app/lib/notification-sweep.server.ts` end to end against a
 * real D1 binding: who the sweep considers due, how many emails a pile
 * of pending outbox rows collapses into, what the links and labels in
 * those emails say, and what happens when the mail transport refuses.
 *
 * The transport is a captured fake — an array of `{to, subject, html}`
 * the assertions read back — so nothing here touches the network and
 * the rendered body can be inspected directly. That is how the
 * escaping, locale, and grouping cases are checked: not by trusting the
 * renderer's contract, but by reading the HTML the recipient would get.
 *
 * FIXTURES sit inside the Neogranadina federation seeded by
 * `cleanDatabase()`: the lead tenant (`neogranadina`) plus one member
 * (`sweep-member`), so a shared-space question with no tenant of its own
 * can be checked to link through the lead's host while its recipient's
 * account link stays on the member's.
 *
 * @version v0.7.0
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "../../app/db/schema";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import {
  NEOGRANADINA_TENANT_ID,
  NEOGRANADINA_FEDERATION_ID,
} from "../../app/lib/tenant";
import { runNotificationSweep } from "../../app/lib/notification-sweep.server";
import type { AppConfig } from "../../app/lib/config.server";

const MEMBER_TENANT_ID = "5a5a0000-0000-4000-8000-00000000000a";
const MEMBER_TENANT_SLUG = "sweep-member";

const HOST_SUFFIX = ".fisqua.test";
const APP_CONFIG: AppConfig = {
  appName: "Fisqua",
  senderEmail: "noreply@example.test",
};

const HOUR = 3_600_000;
const DAY = 86_400_000;

async function seedMemberTenant(): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, name, kind, descriptive_standard, status, " +
      "crowdsourcing_enabled, vocabulary_hub_enabled, publish_pipeline_enabled, multi_repository_enabled, " +
      "quota_storage_bytes, federation_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      MEMBER_TENANT_ID,
      MEMBER_TENANT_SLUG,
      "Sweep Member",
      "tenant",
      "isadg",
      "active",
      0,
      1,
      0,
      0,
      null,
      NEOGRANADINA_FEDERATION_ID,
      now,
      now,
    )
    .run();
}

async function seedUser(opts: {
  id: string;
  tenantId?: string;
  digestFrequency?: string;
  lastDigestAt?: number | null;
  locale?: "en" | "es" | null;
}): Promise<string> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, tenant_id, email, is_admin, digest_frequency, last_digest_at, locale, created_at, updated_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      opts.id,
      opts.tenantId ?? MEMBER_TENANT_ID,
      `${opts.id}@test.local`,
      1,
      opts.digestFrequency ?? "hourly",
      opts.lastDigestAt ?? null,
      opts.locale ?? null,
      now,
      now,
    )
    .run();
  return `${opts.id}@test.local`;
}

async function seedProposalDecision(opts: {
  id: string;
  tenantId: string | null;
  proposedName?: string;
  heading?: string;
}): Promise<void> {
  const db = drizzle(env.DB, { schema });
  await db.insert(schema.pendingDecisions).values({
    id: opts.id,
    federationId: NEOGRANADINA_FEDERATION_ID,
    tenantId: opts.tenantId,
    kind: "authority-proposal",
    payload: JSON.stringify({
      heading: opts.heading ?? "Heading as printed",
      proposedType: "person",
      proposedName: opts.proposedName ?? "Juan de la Cruz",
      action: "mint",
    }),
    sourceModule: "test-fixture",
    status: "open",
    createdAt: Date.now(),
  });
}

async function seedEntity(id: string, displayName: string): Promise<void> {
  const db = drizzle(env.DB, { schema });
  const now = Date.now();
  await db.insert(schema.entities).values({
    id,
    federationId: NEOGRANADINA_FEDERATION_ID,
    tenantId: MEMBER_TENANT_ID,
    displayName,
    sortName: displayName,
    entityType: "person",
    createdAt: now,
    updatedAt: now,
  });
}

async function seedPairDecision(opts: {
  id: string;
  tenantId: string | null;
  pair: [string, string];
  recordType?: "entity" | "place";
}): Promise<void> {
  const db = drizzle(env.DB, { schema });
  await db.insert(schema.pendingDecisions).values({
    id: opts.id,
    federationId: NEOGRANADINA_FEDERATION_ID,
    tenantId: opts.tenantId,
    kind: "duplicate-pair",
    payload: JSON.stringify({
      recordType: opts.recordType ?? "entity",
      pair: opts.pair,
    }),
    sourceModule: "test-fixture",
    sourceRef: `${opts.pair[0]}|${opts.pair[1]}`,
    status: "open",
    createdAt: Date.now(),
  });
}

async function seedOutbox(opts: {
  id: string;
  userId: string;
  kind: "decision_ruled" | "decision_comment" | "proposal_filed";
  decisionId: string;
  createdAt?: number;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO notification_outbox (id, user_id, kind, decision_id, actor_user_id, created_at, sent_at) " +
      "VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      opts.id,
      opts.userId,
      opts.kind,
      opts.decisionId,
      null,
      opts.createdAt ?? Date.now(),
      null,
    )
    .run();
}

type SentMail = { to: string; subject: string; html: string };

function capturingSender(sink: SentMail[]) {
  return async (to: string, subject: string, html: string) => {
    sink.push({ to, subject, html });
  };
}

async function outboxRow(id: string) {
  const db = drizzle(env.DB, { schema });
  return db
    .select()
    .from(schema.notificationOutbox)
    .where(eq(schema.notificationOutbox.id, id))
    .get();
}

async function userRow(id: string) {
  const db = drizzle(env.DB, { schema });
  return db.select().from(schema.users).where(eq(schema.users.id, id)).get();
}

describe("notification sweep", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await seedMemberTenant();
  });

  // -------------------------------------------------------------------
  // 1-3. Due-ness
  // -------------------------------------------------------------------

  it("sends a first digest to an hourly recipient who has never had one", async () => {
    const db = drizzle(env.DB, { schema });
    const now = 1_800_000_000_000;
    const email = await seedUser({ id: "u-1", lastDigestAt: null });
    await seedProposalDecision({ id: "d-1", tenantId: MEMBER_TENANT_ID });
    await seedOutbox({
      id: "o-1",
      userId: "u-1",
      kind: "decision_ruled",
      decisionId: "d-1",
    });

    const sink: SentMail[] = [];
    const counts = await runNotificationSweep(db, {
      now,
      hostSuffix: HOST_SUFFIX,
      appConfig: APP_CONFIG,
      sendEmail: capturingSender(sink),
    });

    expect(counts).toEqual({ due: 1, sent: 1, failed: 0 });
    expect(sink).toHaveLength(1);
    expect(sink[0].to).toBe(email);
    expect(sink[0].html).toContain(
      `https://${MEMBER_TENANT_SLUG}${HOST_SUFFIX}/admin/decisions/d-1`,
    );
    expect(sink[0].html).toContain("Juan de la Cruz");
    // The account link goes to the recipient's own workspace.
    expect(sink[0].html).toContain(
      `https://${MEMBER_TENANT_SLUG}${HOST_SUFFIX}/configuracion`,
    );

    expect((await outboxRow("o-1"))?.sentAt).toBe(now);
    expect((await userRow("u-1"))?.lastDigestAt).toBe(now);
  });

  it("leaves an hourly recipient alone ten minutes after their last digest", async () => {
    const db = drizzle(env.DB, { schema });
    const now = 1_800_000_000_000;
    await seedUser({ id: "u-2", lastDigestAt: now - 10 * 60_000 });
    await seedProposalDecision({ id: "d-2", tenantId: MEMBER_TENANT_ID });
    await seedOutbox({
      id: "o-2",
      userId: "u-2",
      kind: "decision_ruled",
      decisionId: "d-2",
    });

    const sink: SentMail[] = [];
    const counts = await runNotificationSweep(db, {
      now,
      hostSuffix: HOST_SUFFIX,
      appConfig: APP_CONFIG,
      sendEmail: capturingSender(sink),
    });

    expect(counts).toEqual({ due: 0, sent: 0, failed: 0 });
    expect(sink).toHaveLength(0);
    expect((await outboxRow("o-2"))?.sentAt).toBeNull();
    expect((await userRow("u-2"))?.lastDigestAt).toBe(now - 10 * 60_000);
  });

  it("holds a weekly recipient at six days and releases them at eight", async () => {
    const db = drizzle(env.DB, { schema });
    const now = 1_800_000_000_000;
    await seedUser({
      id: "u-3",
      digestFrequency: "weekly",
      lastDigestAt: now - 6 * DAY,
    });
    await seedProposalDecision({ id: "d-3", tenantId: MEMBER_TENANT_ID });
    await seedOutbox({
      id: "o-3",
      userId: "u-3",
      kind: "decision_ruled",
      decisionId: "d-3",
    });

    const early: SentMail[] = [];
    expect(
      await runNotificationSweep(db, {
        now,
        hostSuffix: HOST_SUFFIX,
        appConfig: APP_CONFIG,
        sendEmail: capturingSender(early),
      }),
    ).toEqual({ due: 0, sent: 0, failed: 0 });
    expect(early).toHaveLength(0);

    const late: SentMail[] = [];
    expect(
      await runNotificationSweep(db, {
        now: now + 2 * DAY,
        hostSuffix: HOST_SUFFIX,
        appConfig: APP_CONFIG,
        sendEmail: capturingSender(late),
      }),
    ).toEqual({ due: 1, sent: 1, failed: 0 });
    expect(late).toHaveLength(1);
  });

  it("holds a 15min recipient at ten minutes and releases them at twenty", async () => {
    const db = drizzle(env.DB, { schema });
    const now = 1_800_000_000_000;
    await seedUser({
      id: "u-4",
      digestFrequency: "15min",
      lastDigestAt: now - 10 * 60_000,
    });
    await seedProposalDecision({ id: "d-4", tenantId: MEMBER_TENANT_ID });
    await seedOutbox({
      id: "o-4",
      userId: "u-4",
      kind: "decision_comment",
      decisionId: "d-4",
    });

    const early: SentMail[] = [];
    expect(
      await runNotificationSweep(db, {
        now,
        hostSuffix: HOST_SUFFIX,
        appConfig: APP_CONFIG,
        sendEmail: capturingSender(early),
      }),
    ).toEqual({ due: 0, sent: 0, failed: 0 });

    const late: SentMail[] = [];
    expect(
      await runNotificationSweep(db, {
        now: now + 10 * 60_000,
        hostSuffix: HOST_SUFFIX,
        appConfig: APP_CONFIG,
        sendEmail: capturingSender(late),
      }),
    ).toEqual({ due: 1, sent: 1, failed: 0 });
    expect(late).toHaveLength(1);
  });

  // -------------------------------------------------------------------
  // 4. Coalescing
  // -------------------------------------------------------------------

  it("collapses three pending rows into one email with two items", async () => {
    const db = drizzle(env.DB, { schema });
    const now = 1_800_000_000_000;
    await seedUser({ id: "u-5", lastDigestAt: null });
    await seedProposalDecision({
      id: "d-5a",
      tenantId: MEMBER_TENANT_ID,
      proposedName: "Comentada",
    });
    await seedProposalDecision({
      id: "d-5b",
      tenantId: MEMBER_TENANT_ID,
      proposedName: "Resuelta",
    });
    await seedOutbox({
      id: "o-5a",
      userId: "u-5",
      kind: "decision_comment",
      decisionId: "d-5a",
    });
    await seedOutbox({
      id: "o-5b",
      userId: "u-5",
      kind: "decision_comment",
      decisionId: "d-5a",
    });
    await seedOutbox({
      id: "o-5c",
      userId: "u-5",
      kind: "decision_ruled",
      decisionId: "d-5b",
    });

    const sink: SentMail[] = [];
    const counts = await runNotificationSweep(db, {
      now,
      hostSuffix: HOST_SUFFIX,
      appConfig: APP_CONFIG,
      sendEmail: capturingSender(sink),
    });

    expect(counts).toEqual({ due: 1, sent: 1, failed: 0 });
    expect(sink).toHaveLength(1);
    // Two items, not three: the duplicate comment row collapses.
    expect(sink[0].subject).toBe("2 novedades en Fisqua");
    expect(sink[0].html.match(/<li[\s>]/g)).toHaveLength(2);
    expect(sink[0].html).toContain("Se resolvió 1 pregunta que planteaste");
    expect(sink[0].html).toContain(
      "Hay comentarios nuevos en 1 pregunta en la que participaste",
    );
    expect(sink[0].html).toContain("Comentada");
    expect(sink[0].html).toContain("Resuelta");

    for (const id of ["o-5a", "o-5b", "o-5c"]) {
      expect((await outboxRow(id))?.sentAt).toBe(now);
    }
  });

  // -------------------------------------------------------------------
  // 5. Locale
  // -------------------------------------------------------------------

  it("renders in English for an en recipient and Spanish when locale is null", async () => {
    const db = drizzle(env.DB, { schema });
    const now = 1_800_000_000_000;
    await seedUser({ id: "u-6en", locale: "en" });
    await seedUser({ id: "u-6es", locale: null });
    await seedProposalDecision({ id: "d-6", tenantId: MEMBER_TENANT_ID });
    await seedOutbox({
      id: "o-6en",
      userId: "u-6en",
      kind: "decision_ruled",
      decisionId: "d-6",
    });
    await seedOutbox({
      id: "o-6es",
      userId: "u-6es",
      kind: "decision_ruled",
      decisionId: "d-6",
    });

    const sink: SentMail[] = [];
    await runNotificationSweep(db, {
      now,
      hostSuffix: HOST_SUFFIX,
      appConfig: APP_CONFIG,
      sendEmail: capturingSender(sink),
    });

    const english = sink.find((m) => m.to === "u-6en@test.local");
    const spanish = sink.find((m) => m.to === "u-6es@test.local");
    expect(english?.subject).toBe("1 update in Fisqua");
    expect(english?.html).toContain("1 question you raised was ruled");
    expect(spanish?.subject).toBe("1 novedad en Fisqua");
    expect(spanish?.html).toContain("Se resolvió 1 pregunta que planteaste");
  });

  // -------------------------------------------------------------------
  // 6. Transport failure
  // -------------------------------------------------------------------

  it("marks nothing when the transport throws and delivers on the next sweep", async () => {
    const db = drizzle(env.DB, { schema });
    const now = 1_800_000_000_000;
    await seedUser({ id: "u-7", lastDigestAt: null });
    await seedProposalDecision({ id: "d-7", tenantId: MEMBER_TENANT_ID });
    await seedOutbox({
      id: "o-7",
      userId: "u-7",
      kind: "decision_ruled",
      decisionId: "d-7",
    });

    const counts = await runNotificationSweep(db, {
      now,
      hostSuffix: HOST_SUFFIX,
      appConfig: APP_CONFIG,
      sendEmail: async () => {
        throw new Error("provider rejected");
      },
    });
    expect(counts).toEqual({ due: 1, sent: 0, failed: 1 });
    expect((await outboxRow("o-7"))?.sentAt).toBeNull();
    expect((await userRow("u-7"))?.lastDigestAt).toBeNull();

    const sink: SentMail[] = [];
    const retry = await runNotificationSweep(db, {
      now: now + HOUR,
      hostSuffix: HOST_SUFFIX,
      appConfig: APP_CONFIG,
      sendEmail: capturingSender(sink),
    });
    expect(retry).toEqual({ due: 1, sent: 1, failed: 0 });
    expect(sink).toHaveLength(1);
    expect((await outboxRow("o-7"))?.sentAt).toBe(now + HOUR);
    expect((await userRow("u-7"))?.lastDigestAt).toBe(now + HOUR);
  });

  // -------------------------------------------------------------------
  // 7-8. Labels, URLs, and shared-space hosts
  // -------------------------------------------------------------------

  it("labels and links a duplicate pair through the pair route", async () => {
    const db = drizzle(env.DB, { schema });
    const now = 1_800_000_000_000;
    await seedUser({ id: "u-8" });
    await seedEntity("e-8a", "Bogotá");
    await seedEntity("e-8b", "Santafé");
    await seedPairDecision({
      id: "d-8",
      tenantId: MEMBER_TENANT_ID,
      pair: ["e-8a", "e-8b"],
    });
    await seedOutbox({
      id: "o-8",
      userId: "u-8",
      kind: "decision_comment",
      decisionId: "d-8",
    });

    const sink: SentMail[] = [];
    await runNotificationSweep(db, {
      now,
      hostSuffix: HOST_SUFFIX,
      appConfig: APP_CONFIG,
      sendEmail: capturingSender(sink),
    });

    expect(sink).toHaveLength(1);
    expect(sink[0].html).toContain(
      `https://${MEMBER_TENANT_SLUG}${HOST_SUFFIX}/admin/decisions/pair?type=entities&amp;a=e-8a&amp;b=e-8b`,
    );
    expect(sink[0].html).toContain("Bogotá · Santafé");
  });

  it("links a shared-space question through the federation lead tenant", async () => {
    const db = drizzle(env.DB, { schema });
    const now = 1_800_000_000_000;
    await seedUser({ id: "u-9" });
    await seedProposalDecision({ id: "d-9", tenantId: null });
    await seedOutbox({
      id: "o-9",
      userId: "u-9",
      kind: "proposal_filed",
      decisionId: "d-9",
    });

    const sink: SentMail[] = [];
    await runNotificationSweep(db, {
      now,
      hostSuffix: HOST_SUFFIX,
      appConfig: APP_CONFIG,
      sendEmail: capturingSender(sink),
    });

    expect(sink).toHaveLength(1);
    // The question links on the lead tenant's host...
    expect(sink[0].html).toContain(
      `https://neogranadina${HOST_SUFFIX}/admin/decisions/d-9`,
    );
    // ...while the recipient's settings link stays on their own.
    expect(sink[0].html).toContain(
      `https://${MEMBER_TENANT_SLUG}${HOST_SUFFIX}/configuracion`,
    );
    expect(sink[0].html).toContain("1 propuesta nueva espera tu decisión");
  });

  // -------------------------------------------------------------------
  // 9. Preference is prospective
  // -------------------------------------------------------------------

  it("skips an off recipient and leaves a stray pending row untouched", async () => {
    const db = drizzle(env.DB, { schema });
    const now = 1_800_000_000_000;
    await seedUser({ id: "u-10", digestFrequency: "off", lastDigestAt: null });
    await seedProposalDecision({ id: "d-10", tenantId: MEMBER_TENANT_ID });
    await seedOutbox({
      id: "o-10",
      userId: "u-10",
      kind: "decision_ruled",
      decisionId: "d-10",
    });

    const sink: SentMail[] = [];
    const counts = await runNotificationSweep(db, {
      now,
      hostSuffix: HOST_SUFFIX,
      appConfig: APP_CONFIG,
      sendEmail: capturingSender(sink),
    });

    expect(counts).toEqual({ due: 0, sent: 0, failed: 0 });
    expect(sink).toHaveLength(0);
    expect((await outboxRow("o-10"))?.sentAt).toBeNull();
    expect((await userRow("u-10"))?.lastDigestAt).toBeNull();
  });

  // -------------------------------------------------------------------
  // 10. Escaping
  // -------------------------------------------------------------------

  it("escapes markup in an archival display name", async () => {
    const db = drizzle(env.DB, { schema });
    const now = 1_800_000_000_000;
    await seedUser({ id: "u-11" });
    await seedEntity("e-11a", "Tunja <b>&");
    await seedEntity("e-11b", "Tunxa");
    await seedPairDecision({
      id: "d-11",
      tenantId: MEMBER_TENANT_ID,
      pair: ["e-11a", "e-11b"],
    });
    await seedOutbox({
      id: "o-11",
      userId: "u-11",
      kind: "decision_comment",
      decisionId: "d-11",
    });

    const sink: SentMail[] = [];
    await runNotificationSweep(db, {
      now,
      hostSuffix: HOST_SUFFIX,
      appConfig: APP_CONFIG,
      sendEmail: capturingSender(sink),
    });

    expect(sink).toHaveLength(1);
    expect(sink[0].html).toContain("Tunja &lt;b&gt;&amp; · Tunxa");
    expect(sink[0].html).not.toContain("<b>");
  });
});

// @version v0.7.0
