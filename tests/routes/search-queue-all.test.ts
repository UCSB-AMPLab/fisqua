/**
 * Tests — adding every search result to the digitization queue
 *
 * This suite covers the search page's `queueAll` action, which puts the
 * whole matching set of a records search in the digitization queue. The
 * set is resolved on the server by re-running the posted question, as a
 * handlist save of "all matching" is. The suite checks that every
 * result goes in and an entry already queued is counted rather than
 * added twice; that a set larger than `MAX_RESULTS` is refused with
 * nothing added; that a set whose size differs from the count the button
 * showed is refused with nothing added; and the gates: a bare 404
 * without the digitization capability, a bare 403 for someone who does
 * not work in capture. The record index is re-run even when the URL
 * carries `cat=transcripts`, because the page has no transcripts tab and
 * its count is the record index's; and another tenant's records never
 * count or enter.
 *
 * The Workers pool rolls back each test's writes, so the pages are
 * seeded before every test.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { seedOcrFixtures, seedPage, OCR_IDS } from "../helpers/ocr-fixtures";
import { createTestUser } from "../helpers/auth";
import { tenantContext, userContext, type User } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
import { MAX_RESULTS } from "../../app/lib/capture/queue.server";
// Warm the route module graph at file load, so the in-test import does
// not count against the test timeout.
import "../../app/routes/_auth.search";

const QUERY = "q=zumbadorcola";
const TITLED = [
  "0f000000-0000-4000-8000-000000000001",
  "0f000000-0000-4000-8000-000000000002",
  "0f000000-0000-4000-8000-000000000003",
];

async function seedRecord(id: string, tenantId: string, repoId: string, ref: string, title: string) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO descriptions (id, tenant_id, repository_id, description_level, reference_code, title, created_at, updated_at) VALUES (?, ?, ?, 'volume', ?, ?, ?, ?)",
  ).bind(id, tenantId, repoId, ref, title, now, now).run();
}

let admin: User;

function buildContext(user: User, digitizationEnabled = true): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: OCR_IDS.tenantA, digitizationEnabled }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function queueAll(
  expected: number,
  opts: { user?: User; digitizationEnabled?: boolean; query?: string } = {},
) {
  const { action } = await import("../../app/routes/_auth.search");
  const form = new FormData();
  form.set("_action", "queueAll");
  form.set("recordType", "records");
  form.set("query", opts.query ?? QUERY);
  form.set("expected", String(expected));
  try {
    return (await action({
      request: new Request("http://neogranadina.fisqua.test/search", { method: "POST", body: form }),
      context: buildContext(opts.user ?? admin, opts.digitizationEnabled ?? true),
      params: {},
    } as any)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function queuedIds(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT description_id FROM capture_queue_entries WHERE tenant_id = ? AND withdrawn_at IS NULL ORDER BY position",
  ).bind(OCR_IDS.tenantA).all();
  return rows.results.map((r) => String(r.description_id));
}

beforeEach(async () => {
  await applyMigrations();
  await cleanDatabase();
  await seedOcrFixtures();
  for (const [i, id] of TITLED.entries()) {
    await seedRecord(id, OCR_IDS.tenantA, OCR_IDS.repoA, `pe-bn-zum-${i}`, `Zumbadorcola ${i}`);
  }
  await seedRecord("0f000000-0000-4000-8000-0000000000b9", OCR_IDS.tenantB, OCR_IDS.repoB, "co-xx-zum", "Zumbadorcola ajeno");
  // Only in a transcript, so only the page index could find it.
  await seedPage({ descriptionId: OCR_IDS.descA1, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "colibrisolo en la plaza" });
  const row = await createTestUser({ tenantId: OCR_IDS.tenantA, isAdmin: true, name: "Test Admin" });
  admin = makeUserContext({ id: row.id, tenantId: row.tenantId, email: row.email, name: row.name, isAdmin: true });
});

describe("adding every search result to the digitization queue", () => {
  it("adds every result and counts the one already queued", async () => {
    const first = await queueAll(3);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, added: 3, alreadyQueued: 0 });
    expect([...(await queuedIds())].sort()).toEqual([...TITLED].sort());

    const again = await queueAll(3);
    expect(await again.json()).toEqual({ ok: true, added: 0, alreadyQueued: 3 });
    expect(await queuedIds()).toHaveLength(3);
  });

  it("refuses more results than the cap, adding nothing", async () => {
    for (let i = 0; i < MAX_RESULTS; i++) {
      const id = `0e000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      await seedRecord(id, OCR_IDS.tenantA, OCR_IDS.repoA, `pe-bn-extra-${i}`, `Zumbadorcola otra ${i}`);
    }
    const res = await queueAll(MAX_RESULTS + 3);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "results-limit" });
    expect(await queuedIds()).toEqual([]);
  });

  it("re-runs the record index even when the URL names transcripts", async () => {
    const res = await queueAll(1, { query: "q=colibrisolo&cat=transcripts" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "results-changed" });
    expect(await queuedIds()).toEqual([]);
  });

  it("refuses when the results differ in number from what the button showed, adding nothing", async () => {
    const res = await queueAll(2);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "results-changed" });
    expect(await queuedIds()).toEqual([]);
  });

  it("is a bare 404 without the digitization capability", async () => {
    const res = await queueAll(3, { digitizationEnabled: false });
    expect(res.status).toBe(404);
    expect(await queuedIds()).toEqual([]);
  });

  it("is a bare 403 for someone who does not work in capture", async () => {
    const row = await createTestUser({ tenantId: OCR_IDS.tenantA });
    const res = await queueAll(3, { user: makeUserContext({ id: row.id, tenantId: row.tenantId, email: row.email }) });
    expect(res.status).toBe(403);
    expect(await queuedIds()).toEqual([]);
  });
});

// @version v0.9.0
