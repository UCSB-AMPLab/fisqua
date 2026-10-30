/**
 * Test helper — OCR page fixtures
 *
 * This module deals with seeding the rows the OCR tests read: one
 * repository and a handful of descriptions in each of two tenants, and
 * page rows under them. It writes plain SQL rather than going through
 * the Drizzle schema so the same fixtures serve the tests that run
 * before the `ocr_text` column is dropped and the tests that run after.
 *
 * Every OCR term a test searches for is unique to the fixture that
 * carries it, so one test's counts cannot be moved by another's rows.
 *
 * @version v0.8.0
 */
import { env } from "cloudflare:test";
import { seedTenants, DEFAULT_TEST_TENANT_ID, SECOND_TEST_TENANT_ID } from "./db";

export interface OcrFixtureIds {
  tenantA: string;
  tenantB: string;
  repoA: string;
  repoB: string;
  descA1: string;
  descA2: string;
  descA3: string;
  descB1: string;
}

export const OCR_IDS: OcrFixtureIds = {
  tenantA: DEFAULT_TEST_TENANT_ID,
  tenantB: SECOND_TEST_TENANT_ID,
  repoA: "0c000000-0000-4000-8000-00000000000a",
  repoB: "0c000000-0000-4000-8000-00000000000b",
  descA1: "0d000000-0000-4000-8000-0000000000a1",
  descA2: "0d000000-0000-4000-8000-0000000000a2",
  descA3: "0d000000-0000-4000-8000-0000000000a3",
  descB1: "0d000000-0000-4000-8000-0000000000b1",
};

export async function seedOcrFixtures(): Promise<OcrFixtureIds> {
  await seedTenants();
  const now = Date.now();
  const db = env.DB;
  for (const [id, tenant, code] of [
    [OCR_IDS.repoA, OCR_IDS.tenantA, "pe-bn"],
    [OCR_IDS.repoB, OCR_IDS.tenantB, "co-xx"],
  ] as const) {
    await db.prepare(
      "INSERT OR IGNORE INTO repositories (id, tenant_id, code, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, tenant, code, code, now, now).run();
  }
  for (const [id, tenant, repo, ref, title] of [
    [OCR_IDS.descA1, OCR_IDS.tenantA, OCR_IDS.repoA, "pe-bn-cdip-00001", "Carta del cabildo"],
    [OCR_IDS.descA2, OCR_IDS.tenantA, OCR_IDS.repoA, "pe-bn-cdip-00002", "Gaceta de Lima"],
    [OCR_IDS.descA3, OCR_IDS.tenantA, OCR_IDS.repoA, "pe-bn-cdip-00003", "Mercurio Peruano"],
    [OCR_IDS.descB1, OCR_IDS.tenantB, OCR_IDS.repoB, "co-xx-00001", "Otro fondo"],
  ] as const) {
    await db.prepare(
      "INSERT OR IGNORE INTO descriptions (id, tenant_id, repository_id, description_level, reference_code, title, created_at, updated_at) VALUES (?, ?, ?, 'item', ?, ?, ?, ?)",
    ).bind(id, tenant, repo, ref, title, now, now).run();
  }
  return OCR_IDS;
}

export async function seedPage(values: {
  descriptionId: string;
  tenantId: string;
  pageSeq: number;
  text: string;
  runId?: string | null;
  sourceKey?: string | null;
  altoKey?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO ocr_pages (id, tenant_id, description_id, page_seq, text, source_key, alto_key, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    crypto.randomUUID(), values.tenantId, values.descriptionId, values.pageSeq,
    values.text, values.sourceKey ?? null, values.altoKey ?? null, values.runId ?? null, Date.now(),
  ).run();
}
