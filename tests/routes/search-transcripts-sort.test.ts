/**
 * Tests — the search action keeps the sort of a transcripts selection
 *
 * This suite covers `readSearchRequest` through the search page's
 * action. A records selection made on the transcripts tab is posted
 * with `cat=transcripts`, and the action re-runs the OCR page index for
 * it. The posted sort must survive the re-read: `cat=transcripts` is
 * read as a records-index category, so a record sort key such as
 * `title:desc` is kept, and the ids come back in that order. A sort the
 * record keys do not have is still dropped.
 *
 * The Workers pool rolls back each test's writes, so the pages are
 * seeded before every test.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { seedOcrFixtures, seedPage, OCR_IDS } from "../helpers/ocr-fixtures";
import { tenantContext, userContext } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
// Warm the route module graph at file load, so the in-test import does
// not count against the test timeout.
import "../../app/routes/_auth.search";

function buildContext(): any {
  const ctx = new RouterContextProvider();
  ctx.set(userContext, makeUserContext({ isAdmin: true, tenantId: OCR_IDS.tenantA }));
  ctx.set(tenantContext, makeTenantContext({ id: OCR_IDS.tenantA }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function matchingIds(query: string): Promise<string[]> {
  const { action } = await import("../../app/routes/_auth.search");
  const form = new FormData();
  form.set("_action", "handlistIds");
  form.set("recordType", "records");
  form.set("query", query);
  const response = (await action({
    request: new Request("http://neogranadina.fisqua.test/search", { method: "POST", body: form }),
    context: buildContext(),
    params: {},
  } as any)) as Response;
  const body = (await response.json()) as { ok: boolean; ids: string[] };
  expect(body.ok).toBe(true);
  return body.ids;
}

beforeEach(async () => {
  await applyMigrations();
  await cleanDatabase();
  await seedOcrFixtures();
  // Titles: A1 "Carta del cabildo", A2 "Gaceta de Lima", A3 "Mercurio Peruano".
  for (const id of [OCR_IDS.descA1, OCR_IDS.descA2, OCR_IDS.descA3]) {
    await seedPage({ descriptionId: id, tenantId: OCR_IDS.tenantA, pageSeq: 1, text: "zumbadorsort en la plaza" });
  }
});

describe("a transcripts selection posted to the search action", () => {
  it("keeps a posted title sort, descending", async () => {
    const ids = await matchingIds("q=zumbadorsort&cat=transcripts&sort=title%3Adesc");
    expect(ids).toEqual([OCR_IDS.descA3, OCR_IDS.descA2, OCR_IDS.descA1]);
  });

  it("keeps a posted title sort, ascending", async () => {
    const ids = await matchingIds("q=zumbadorsort&cat=transcripts&sort=title%3Aasc");
    expect(ids).toEqual([OCR_IDS.descA1, OCR_IDS.descA2, OCR_IDS.descA3]);
  });

  it("drops a sort key the record index does not have", async () => {
    const ids = await matchingIds("q=zumbadorsort&cat=transcripts&sort=name%3Adesc");
    expect([...ids].sort()).toEqual([OCR_IDS.descA1, OCR_IDS.descA2, OCR_IDS.descA3].sort());
  });
});

// Version: v0.8.0
