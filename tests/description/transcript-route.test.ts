/**
 * Tests — the transcript view's loader
 *
 * This suite covers the loader behind
 * `/admin/descriptions/:id/transcript`: it pages through a
 * description's OCR pages TRANSCRIPT_PAGE_SIZE at a time (`?p=`), finds
 * the pages a term is on (`?q=`), answers 404 for a description held by
 * another workspace, and, when FTS5 rejects the compiled expression (an
 * unbalanced quote), retries once with the sanitised expression as
 * workspace search does, giving no hits rather than an error when
 * nothing survives sanitising. One case reads the route manifest as
 * text, so the loader cannot pass while the URL itself is unregistered
 * and answers 404.
 *
 * The Workers pool rolls back each test's writes, so the pages are
 * seeded before every test.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { applyMigrations, cleanDatabase } from "../helpers/db";
import { seedOcrFixtures, seedPage, OCR_IDS } from "../helpers/ocr-fixtures";
import { tenantContext, userContext } from "../../app/context";
import { makeTenantContext, makeUserContext } from "../helpers/context";
// Warm the route module graph at file load, as the update-action suite
// does, so the in-test import does not count against the test timeout.
import "../../app/routes/_auth.admin.descriptions.$id.transcript";

function buildContext(): any {
  const ctx = new RouterContextProvider();
  const user = makeUserContext({ isAdmin: true, tenantId: OCR_IDS.tenantA });
  ctx.set(userContext, user);
  ctx.set(tenantContext, makeTenantContext({ id: OCR_IDS.tenantA }));
  (ctx as any).cloudflare = { env };
  return ctx;
}

async function runLoader(descriptionId: string, search = ""): Promise<any> {
  const { loader } = await import(
    "../../app/routes/_auth.admin.descriptions.$id.transcript"
  );
  return loader({
    request: new Request(
      `http://neogranadina.fisqua.test/admin/descriptions/${descriptionId}/transcript${search}`,
    ),
    context: buildContext(),
    params: { id: descriptionId },
  } as any);
}

beforeEach(async () => {
  await applyMigrations();
  await cleanDatabase();
  await seedOcrFixtures();
  for (let seq = 1; seq <= 25; seq++) {
    const text = seq === 23 ? "real cedula dada en arequipa" : `folio ${seq} sin nombres`;
    await seedPage({ descriptionId: OCR_IDS.descA1, tenantId: OCR_IDS.tenantA, pageSeq: seq, text });
  }
  await seedPage({ descriptionId: OCR_IDS.descB1, tenantId: OCR_IDS.tenantB, pageSeq: 1, text: "arequipa ajena" });
});

describe("transcript view loader", () => {
  it("reads pages 1-20 on p=1 and 21-25 on p=2", async () => {
    const first = await runLoader(OCR_IDS.descA1, "?p=1");
    expect(first.description).toEqual({
      id: OCR_IDS.descA1, referenceCode: "pe-bn-cdip-00001", title: "Carta del cabildo",
    });
    expect(first.summary.pageCount).toBe(25);
    expect(first.pages.map((p: { seq: number }) => p.seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    expect(first.hits).toEqual([]);

    const second = await runLoader(OCR_IDS.descA1, "?p=2");
    expect(second.pages.map((p: { seq: number }) => p.seq)).toEqual([21, 22, 23, 24, 25]);
  });

  it("answers 404 for a description in another workspace", async () => {
    let thrown: unknown;
    try {
      await runLoader(OCR_IDS.descB1);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it("lists the pages a term is on", async () => {
    const data = await runLoader(OCR_IDS.descA1, "?q=arequipa");
    expect(data.hits.map((h: { seq: number }) => h.seq)).toEqual([23]);
    expect(data.hits[0].snippet).toContain("arequipa");
  });

  it("retries a query FTS5 rejects with the sanitised expression", async () => {
    // The unbalanced quote passes through to FTS5, which rejects it;
    // the spy keeps the expected first-attempt log out of the output.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const data = await runLoader(OCR_IDS.descA1, `?q=${encodeURIComponent('"arequipa')}`);
      expect(data.hits.map((h: { seq: number }) => h.seq)).toEqual([23]);
      expect(data.hits[0].snippet).toContain("arequipa");
      expect(data.pages.length).toBe(20);
    } finally {
      logged.mockRestore();
    }
  });

  it("gives no hits and no error when nothing survives sanitising", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const data = await runLoader(OCR_IDS.descA1, `?q=${encodeURIComponent('"()')}`);
      expect(data.hits).toEqual([]);
      expect(data.pages.length).toBe(20);
    } finally {
      logged.mockRestore();
    }
  });

  it("is registered in the route manifest", () => {
    const files = import.meta.glob("../../app/routes.ts", {
      query: "?raw", import: "default", eager: true,
    }) as Record<string, string>;
    const source = Object.values(files)[0];
    expect(source).toContain(
      'route("admin/descriptions/:id/transcript", "routes/_auth.admin.descriptions.$id.transcript.tsx")',
    );
  });
});

// Version: v0.8.0
