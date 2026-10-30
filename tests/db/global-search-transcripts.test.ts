/**
 * Tests — OCR pages in the workspace search
 *
 * This suite covers the transcripts category of `runGlobalSearch`: a
 * term found only in page text reaches its record, one row per record
 * with its matching-page count and best pages; the count on the tab
 * counts records, not pages; another tenant's pages never appear,
 * including through the snippet read; record facets, date bounds and
 * handlists narrow the category; a workspace without authorities still
 * reaches it; a field-scoped refinement, a browse query and the
 * caller's gate each make the category absent; and a phrase FTS5
 * rejects falls back without taking the other categories down.
 *
 * The id enumeration and the bare count accept the category too, and
 * answer with description ids: the enumeration in the paged read's own
 * order, the count with the tab's number, and both under the same
 * facets, date bounds and authority gate as the paged read. These are
 * what the export carry and "add all to handlist" run.
 *
 * FIXTURES. Every term is unique to this file (`tupac`, `amaru`,
 * `cuzco`, `tinta`, `sorata`), so no other file's rows can move a
 * count here. The Workers pool rolls back each test's writes, so the
 * shared records are seeded before every test, and the rows only one
 * test reads are seeded inside that test.
 *
 * @version v0.8.0
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { applyMigrations, cleanDatabase, getTestDb } from "../helpers/db";
import { seedOcrFixtures, seedPage, OCR_IDS } from "../helpers/ocr-fixtures";
import {
  NEOGRANADINA_FEDERATION_ID,
} from "../../app/lib/tenant";
import { SECOND_TEST_FEDERATION_ID } from "../helpers/db";
import { parseSearch } from "../../app/lib/search-query";
import {
  runGlobalSearch,
  selectMatchingIds,
  countMatching,
  HIGHLIGHT_OPEN,
  HIGHLIGHT_CLOSE,
  TRANSCRIPT_HITS_PER_ROW,
  SEARCH_PAGE_SIZE,
} from "../../app/lib/global-search.server";
import type {
  GlobalSearchScope,
  TranscriptHit,
} from "../../app/lib/global-search.server";

const TENANT_A = OCR_IDS.tenantA;
const TENANT_B = OCR_IDS.tenantB;

/** Page 7 of 9 holds the only tupac. */
const T_SEVEN = "0e000000-0000-4000-8000-000000000001";
/** cuzco on pages 2, 5, 8 and 9; page 8 says it three times. */
const T_CUZCO = "0e000000-0000-4000-8000-000000000002";
/** tupac and amaru on the same page. */
const T_SAME_PAGE = "0e000000-0000-4000-8000-000000000003";
/** tupac on page 1, amaru on page 2. */
const T_SPLIT = "0e000000-0000-4000-8000-000000000004";
/** tinta, dated 1650. */
const T_EARLY = "0e000000-0000-4000-8000-000000000005";
/** tinta, dated 1780. */
const T_LATE = "0e000000-0000-4000-8000-000000000006";
/** Tenant B's record, with tupac in its pages. */
const T_OTHER = "0e000000-0000-4000-8000-0000000000b1";

const USER_A = "0f000000-0000-4000-8000-000000000001";
const HANDLIST = "0f000000-0000-4000-8000-0000000000a1";

function db() {
  return getTestDb();
}

function scope(overrides: Partial<GlobalSearchScope> = {}): GlobalSearchScope {
  return {
    tenantId: TENANT_A,
    federationId: NEOGRANADINA_FEDERATION_ID,
    includeAuthorities: true,
    includeTranscripts: true,
    ...overrides,
  };
}

async function seedRecord(values: {
  id: string;
  tenantId: string;
  repositoryId: string;
  referenceCode: string;
  title: string;
  level?: string;
  dateStart?: string | null;
}): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO descriptions (id, tenant_id, repository_id, description_level, reference_code, title, date_start, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      values.id, values.tenantId, values.repositoryId, values.level ?? "item",
      values.referenceCode, values.title, values.dateStart ?? null, now, now,
    )
    .run();
}

async function seedPages(
  descriptionId: string,
  tenantId: string,
  pages: Record<number, string>,
): Promise<void> {
  for (const [seq, text] of Object.entries(pages)) {
    await seedPage({ descriptionId, tenantId, pageSeq: Number(seq), text });
  }
}

/** Filler pages 1..n, each with text no test searches for. */
function filler(n: number): Record<number, string> {
  const pages: Record<number, string> = {};
  for (let seq = 1; seq <= n; seq++) pages[seq] = `folio ${seq} texto corriente del expediente`;
  return pages;
}

beforeEach(async () => {
  await applyMigrations();
  await cleanDatabase();
  await seedOcrFixtures();
  const repoA = OCR_IDS.repoA;
  await seedRecord({ id: T_SEVEN, tenantId: TENANT_A, repositoryId: repoA, referenceCode: "tr-0001", title: "Carta del corregidor", dateStart: "1781" });
  await seedRecord({ id: T_CUZCO, tenantId: TENANT_A, repositoryId: repoA, referenceCode: "tr-0002", title: "Libro de cabildo", level: "file" });
  await seedRecord({ id: T_SAME_PAGE, tenantId: TENANT_A, repositoryId: repoA, referenceCode: "tr-0003", title: "Informe del visitador" });
  await seedRecord({ id: T_SPLIT, tenantId: TENANT_A, repositoryId: repoA, referenceCode: "tr-0004", title: "Proceso criminal" });
  await seedRecord({ id: T_EARLY, tenantId: TENANT_A, repositoryId: repoA, referenceCode: "tr-0005", title: "Cuentas del obraje", dateStart: "1650" });
  await seedRecord({ id: T_LATE, tenantId: TENANT_A, repositoryId: repoA, referenceCode: "tr-0006", title: "Cuentas de la imprenta", dateStart: "1780" });
  await seedRecord({ id: T_OTHER, tenantId: TENANT_B, repositoryId: OCR_IDS.repoB, referenceCode: "tr-b001", title: "Expediente ajeno" });

  await seedPages(T_SEVEN, TENANT_A, { ...filler(9), 7: "el cacique tupac entra en la plaza" });
  await seedPages(T_CUZCO, TENANT_A, {
    ...filler(9),
    2: "llegada al cuzco",
    5: "vecinos del cuzco",
    8: "cuzco cuzco cuzco",
    9: "salida del cuzco",
  });
  await seedPages(T_SAME_PAGE, TENANT_A, { 1: "tupac amaru en tinta" });
  await seedPages(T_SPLIT, TENANT_A, { 1: "declaracion sobre tupac", 2: "noticia de amaru" });
  await seedPages(T_EARLY, TENANT_A, { 1: "pago de tinta y papel" });
  await seedPages(T_LATE, TENANT_A, { 1: "compra de tinta para la prensa" });
  await seedPages(T_OTHER, TENANT_B, { 1: "tupac en otro archivo" });
});

function transcriptRows(result: Awaited<ReturnType<typeof runGlobalSearch>>): TranscriptHit[] {
  return (result.page?.rows ?? []) as TranscriptHit[];
}

function rowFor(rows: TranscriptHit[], id: string): TranscriptHit | undefined {
  return rows.find((row) => row.id === id);
}

describe("transcripts in the workspace search", () => {
  it("reaches a record by a term found only on one of its pages", async () => {
    const result = await runGlobalSearch(db(), scope(), parseSearch(["tupac"]), { category: "all" });
    const hit = rowFor(result.preview?.transcripts ?? [], T_SEVEN);
    expect(hit).toBeDefined();
    expect(hit!.matchedPages).toBe(1);
    expect(hit!.pages[0].seq).toBe(7);
    expect(hit!.pages[0].snippet).toContain(`${HIGHLIGHT_OPEN}tupac${HIGHLIGHT_CLOSE}`);
    expect(hit!.referenceCode).toBe("tr-0001");
    expect(hit!.title).toBe("Carta del corregidor");
    expect(hit!.dateExpression).toBeNull();
    expect(hit!.level).toBe("item");
  });

  it("returns one row per record with its matching-page count and at most three best pages", async () => {
    const result = await runGlobalSearch(db(), scope(), parseSearch(["cuzco"]), {
      category: "transcripts",
      page: 1,
      facets: {},
      sort: null,
    });
    expect(result.counts.transcripts).toBe(1);
    expect(result.page?.total).toBe(1);
    const rows = transcriptRows(result);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(T_CUZCO);
    expect(rows[0].matchedPages).toBe(4);
    expect(rows[0].pages).toHaveLength(TRANSCRIPT_HITS_PER_ROW);
    expect(rows[0].pages[0].seq).toBe(8);
  });

  it("never returns another tenant's pages, in either direction", async () => {
    // A tenant-B page row hung on a tenant-A record: the page tenant,
    // not the record id, has to keep it out of tenant A's answer.
    await seedPage({ descriptionId: T_SEVEN, tenantId: TENANT_B, pageSeq: 20, text: "tupac tupac tupac ajeno" });

    const fromA = await runGlobalSearch(db(), scope(), parseSearch(["tupac"]), {
      category: "transcripts",
      page: 1,
      facets: {},
      sort: null,
    });
    const idsA = transcriptRows(fromA).map((row) => row.id).sort();
    expect(idsA).toEqual([T_SEVEN, T_SAME_PAGE, T_SPLIT].sort());
    const seven = rowFor(transcriptRows(fromA), T_SEVEN)!;
    expect(seven.matchedPages).toBe(1);
    expect(seven.pages.map((page) => page.seq)).toEqual([7]);
    for (const row of transcriptRows(fromA)) {
      for (const page of row.pages) expect(page.snippet ?? "").not.toContain("ajeno");
    }

    const fromB = await runGlobalSearch(
      db(),
      scope({ tenantId: TENANT_B, federationId: SECOND_TEST_FEDERATION_ID }),
      parseSearch(["tupac"]),
      { category: "transcripts", page: 1, facets: {}, sort: null },
    );
    expect(transcriptRows(fromB).map((row) => row.id)).toEqual([T_OTHER]);
    expect(fromB.counts.transcripts).toBe(1);
  });

  it("leaves the record index alone: page text does not count as a record match", async () => {
    const result = await runGlobalSearch(db(), scope(), parseSearch(["tupac"]), { category: "all" });
    expect(result.counts.descriptions).toBe(0);
    expect(result.counts.transcripts).toBe(3);
  });

  it("narrows by level, with an honest total under the facet", async () => {
    const miss = await runGlobalSearch(db(), scope(), parseSearch(["cuzco"]), {
      category: "transcripts",
      page: 1,
      facets: { levels: ["fonds"] },
      sort: null,
    });
    expect(transcriptRows(miss)).toHaveLength(0);
    expect(miss.page?.total).toBe(0);
    expect(miss.counts.transcripts).toBe(1);

    const hit = await runGlobalSearch(db(), scope(), parseSearch(["cuzco"]), {
      category: "transcripts",
      page: 1,
      facets: { levels: ["file"] },
      sort: null,
    });
    expect(transcriptRows(hit).map((row) => row.id)).toEqual([T_CUZCO]);
    expect(hit.page?.total).toBe(1);
    // The sidebar counts the selected category's matches.
    expect(hit.facetCounts.levels).toEqual([{ value: "file", count: 1 }]);
  });

  it("is absent under a field-scoped refinement", async () => {
    const result = await runGlobalSearch(db(), scope(), parseSearch(["tupac", "title:carta"]), {
      category: "all",
    });
    expect(result.counts.transcripts).toBeUndefined();
    expect(result.preview?.transcripts).toEqual([]);
  });

  it("is absent when the query only excludes (browse)", async () => {
    const result = await runGlobalSearch(db(), scope(), parseSearch(["-tupac"]), { category: "all" });
    expect(result.mode).toBe("browse");
    expect(result.counts.transcripts).toBeUndefined();
  });

  it("is absent when the caller's gate is off or unset, and asking for it then throws", async () => {
    for (const gated of [scope({ includeTranscripts: false }), { ...scope(), includeTranscripts: undefined }]) {
      const result = await runGlobalSearch(db(), gated, parseSearch(["tupac"]), { category: "all" });
      expect(result.counts.transcripts).toBeUndefined();
      await expect(
        runGlobalSearch(db(), gated, parseSearch(["tupac"]), {
          category: "transcripts",
          page: 1,
          facets: {},
          sort: null,
        }),
      ).rejects.toThrow(/transcripts/);
    }
  });

  it("subtracts excluded terms page by page, not record by record", async () => {
    const result = await runGlobalSearch(db(), scope(), parseSearch(["tupac -amaru"]), {
      category: "transcripts",
      page: 1,
      facets: {},
      sort: null,
    });
    const ids = transcriptRows(result).map((row) => row.id);
    expect(ids).not.toContain(T_SAME_PAGE);
    expect(ids).toContain(T_SPLIT);
    expect(ids).toContain(T_SEVEN);
  });

  it("falls back on a phrase FTS5 rejects without taking the record category down", async () => {
    const result = await runGlobalSearch(db(), scope(), parseSearch(['"tupac']), { category: "all" });
    expect(typeof result.counts.descriptions).toBe("number");
    expect([0, 3]).toContain(result.counts.transcripts);
  });

  it("pages through records, not pages", async () => {
    for (let i = 1; i <= 30; i++) {
      const id = `0e100000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      await seedRecord({
        id,
        tenantId: TENANT_A,
        repositoryId: OCR_IDS.repoA,
        referenceCode: `tr-s${String(i).padStart(3, "0")}`,
        title: `Registro ${i}`,
      });
      await seedPages(id, TENANT_A, { 1: "camino de sorata", 2: "regreso de sorata" });
    }
    const result = await runGlobalSearch(db(), scope(), parseSearch(["sorata"]), {
      category: "transcripts",
      page: 2,
      facets: {},
      sort: null,
    });
    expect(result.page?.total).toBe(30);
    expect(result.counts.transcripts).toBe(30);
    expect(transcriptRows(result)).toHaveLength(5);
    expect(result.page?.pageNumber).toBe(2);
  });

  it("narrows to a handlist's members", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO users (id, tenant_id, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(USER_A, TENANT_A, "transcripts@example.org", now, now).run();
    await env.DB.prepare(
      "INSERT INTO handlists (id, tenant_id, owner_id, name, record_type, created_at, updated_at) VALUES (?, ?, ?, ?, 'records', ?, ?)",
    ).bind(HANDLIST, TENANT_A, USER_A, "Tinta", now, now).run();
    await env.DB.prepare(
      "INSERT INTO handlist_members (id, handlist_id, member_id, position, created_at) VALUES (?, ?, ?, 0, ?)",
    ).bind(crypto.randomUUID(), HANDLIST, T_LATE, now).run();

    const whole = await runGlobalSearch(db(), scope(), parseSearch(["tinta"]), {
      category: "transcripts",
      page: 1,
      facets: {},
      sort: null,
    });
    expect(whole.counts.transcripts).toBe(3);

    const within = await runGlobalSearch(db(), scope({ handlistId: HANDLIST }), parseSearch(["tinta"]), {
      category: "transcripts",
      page: 1,
      facets: {},
      sort: null,
    });
    expect(within.counts.transcripts).toBe(1);
    expect(transcriptRows(within).map((row) => row.id)).toEqual([T_LATE]);
  });

  it("answers for a workspace without authorities", async () => {
    const result = await runGlobalSearch(
      db(),
      scope({ includeAuthorities: false }),
      parseSearch(["tupac"]),
      { category: "transcripts", page: 1, facets: {}, sort: null },
    );
    expect(result.page?.total).toBe(3);
    expect(result.counts.entities).toBeUndefined();
    expect(result.counts.transcripts).toBe(3);
  });

  it("keeps the category under a date bound, which narrows through the record", async () => {
    const result = await runGlobalSearch(db(), scope(), parseSearch(["tinta"]), {
      category: "transcripts",
      page: 1,
      facets: { dateFrom: "1700" },
      sort: null,
    });
    expect(transcriptRows(result).map((row) => row.id)).toEqual([T_LATE]);
    expect(result.page?.total).toBe(1);
    // The tab count stays facet-free.
    expect(result.counts.transcripts).toBe(3);
  });

  it("enumerates and counts the category as description ids", async () => {
    const matched = await selectMatchingIds(db(), scope(), parseSearch(["tupac"]), {
      category: "transcripts",
      facets: {},
      sort: null,
      limit: 100,
    });
    expect(matched.total).toBe(3);
    expect([...matched.ids].sort()).toEqual([T_SEVEN, T_SAME_PAGE, T_SPLIT].sort());

    expect(
      await countMatching(db(), scope(), parseSearch(["tinta"]), {
        category: "transcripts",
        facets: { dateFrom: "1700" },
      }),
    ).toBe(1);

    await expect(
      countMatching(db(), scope({ includeTranscripts: false }), parseSearch(["tupac"]), {
        category: "transcripts",
        facets: {},
      }),
    ).rejects.toThrow(/transcripts/);
  });

  it("enumerates the records behind transcript hits, in page-read order", async () => {
    for (let i = 1; i <= 30; i++) {
      const id = `0e200000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      await seedRecord({
        id,
        tenantId: TENANT_A,
        repositoryId: OCR_IDS.repoA,
        referenceCode: `tr-o${String(i).padStart(3, "0")}`,
        title: `Registro ${i}`,
      });
      // A different number of matching pages per record, so relevance
      // separates them and the order is not an accident of insertion.
      const pages: Record<number, string> = {};
      for (let seq = 1; seq <= 1 + (i % 4); seq++) pages[seq] = "camino de sorata";
      await seedPages(id, TENANT_A, pages);
    }
    for (const sort of [null, { key: "code" as const, dir: "desc" as const }]) {
      const paged = await runGlobalSearch(db(), scope(), parseSearch(["sorata"]), {
        category: "transcripts",
        page: 1,
        facets: {},
        sort,
      });
      const pageIds = transcriptRows(paged).map((row) => row.id);
      expect(pageIds).toHaveLength(SEARCH_PAGE_SIZE);

      const matched = await selectMatchingIds(db(), scope(), parseSearch(["sorata"]), {
        category: "transcripts",
        facets: {},
        sort,
        limit: 100,
      });
      expect(matched.total).toBe(30);
      expect(matched.ids).toHaveLength(30);
      expect(matched.ids.slice(0, SEARCH_PAGE_SIZE)).toEqual(pageIds);
    }
  });

  it("counts the same records the tab counts", async () => {
    for (const term of ["tupac", "cuzco", "tinta", "tupac -amaru"]) {
      const result = await runGlobalSearch(db(), scope(), parseSearch([term]), { category: "all" });
      const counted = await countMatching(db(), scope(), parseSearch([term]), {
        category: "transcripts",
        facets: {},
      });
      expect(counted).toBe(result.counts.transcripts);
    }
  });

  it("enumerates and counts without authorities and under a date bound", async () => {
    const gated = scope({ includeAuthorities: false, includeTranscripts: true });
    const facets = { dateFrom: "1700" };
    const paged = await runGlobalSearch(db(), gated, parseSearch(["tinta"]), {
      category: "transcripts",
      page: 1,
      facets,
      sort: null,
    });
    const matched = await selectMatchingIds(db(), gated, parseSearch(["tinta"]), {
      category: "transcripts",
      facets,
      sort: null,
      limit: 100,
    });
    const counted = await countMatching(db(), gated, parseSearch(["tinta"]), {
      category: "transcripts",
      facets,
    });
    expect(matched.ids).toEqual(transcriptRows(paged).map((row) => row.id));
    expect(matched.ids).toEqual([T_LATE]);
    expect(matched.total).toBe(paged.page?.total);
    expect(counted).toBe(paged.page?.total);
  });
});
